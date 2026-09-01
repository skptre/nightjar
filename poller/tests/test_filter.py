from unittest.mock import MagicMock

from poller.filter import (
    filter_feed_mapping,
    filter_student_roles,
    filter_us_locations,
    is_student_role,
    is_us_location,
)


class TestIsStudentRole:
    def test_intern(self) -> None:
        assert is_student_role("Software Engineering Intern")

    def test_internship(self) -> None:
        assert is_student_role("Summer 2027 Internship - Data Science")

    def test_coop(self) -> None:
        assert is_student_role("Mechanical Engineering Co-op")

    def test_coop_no_hyphen(self) -> None:
        assert is_student_role("Electrical Engineering Coop")

    def test_summer_analyst(self) -> None:
        assert is_student_role("Summer Analyst 2027 - Investment Banking")

    def test_summer_associate(self) -> None:
        assert is_student_role("Summer Associate - Fixed Income")

    def test_new_grad(self) -> None:
        assert is_student_role("New Grad Software Engineer 2027")

    def test_new_graduate(self) -> None:
        assert is_student_role("New Graduate - Backend Engineer")

    def test_entry_level_is_not_specific_enough(self) -> None:
        assert not is_student_role("Entry-Level Data Analyst")

    def test_entry_level_space_is_not_specific_enough(self) -> None:
        assert not is_student_role("Entry Level Mechanical Engineer")

    def test_early_career_is_not_specific_enough(self) -> None:
        assert not is_student_role("Early Career Software Developer")

    def test_apprenticeship_is_out_of_scope(self) -> None:
        assert not is_student_role("Software Apprenticeship Program")

    def test_student_trainee(self) -> None:
        assert is_student_role("Student Trainee (Engineering)")

    def test_reu_is_out_of_scope(self) -> None:
        assert not is_student_role("REU - Materials Science")

    def test_industrial_placement_is_out_of_scope(self) -> None:
        assert not is_student_role("Industrial Placement - Aerospace")

    def test_year_in_industry_is_out_of_scope(self) -> None:
        assert not is_student_role("Year in Industry - Software Development")

    def test_campus_hire(self) -> None:
        assert is_student_role("Campus Hire - Quantitative Analyst")

    def test_recent_graduate(self) -> None:
        assert is_student_role("Recent Graduate - Civil Engineer")

    def test_spring_week_is_out_of_scope(self) -> None:
        assert not is_student_role("Spring Week - Markets")

    def test_externship_is_out_of_scope(self) -> None:
        assert not is_student_role("Externship - Product Design")

    def test_practicum_is_out_of_scope(self) -> None:
        assert not is_student_role("Practicum - Clinical Engineering")

    def test_graduate_trainee(self) -> None:
        assert is_student_role("Graduate Trainee - Finance")

    def test_regular_swe_rejected(self) -> None:
        assert not is_student_role("Software Engineer")

    def test_senior_rejected(self) -> None:
        assert not is_student_role("Senior Backend Engineer")

    def test_manager_rejected(self) -> None:
        assert not is_student_role("Engineering Manager")

    def test_director_rejected(self) -> None:
        assert not is_student_role("Director of Product")

    def test_cafe_ambassador_rejected(self) -> None:
        assert not is_student_role("Café Ambassador- Walnut Creek (Part Time)")

    def test_case_insensitive(self) -> None:
        assert is_student_role("SOFTWARE ENGINEERING INTERN")
        assert is_student_role("summer analyst 2027")
        assert is_student_role("NEW GRAD")

    def test_internal_not_intern(self) -> None:
        assert not is_student_role("Internal Tools Engineer")

    def test_international_not_intern(self) -> None:
        assert not is_student_role("International Sales Manager")

    def test_plural_internships(self) -> None:
        assert is_student_role("2027 Software Engineering Internships")


class TestFilterStudentRoles:
    def test_filters_non_student(self) -> None:
        intern = MagicMock()
        intern.title = "Software Engineering Intern"
        swe = MagicMock()
        swe.title = "Software Engineer"
        new_grad = MagicMock()
        new_grad.title = "New Grad - Backend"

        result = filter_student_roles([intern, swe, new_grad])
        assert len(result) == 2
        assert intern in result
        assert new_grad in result
        assert swe not in result

    def test_empty_list(self) -> None:
        assert filter_student_roles([]) == []


class TestIsUsLocation:
    def test_city_state_abbrev(self) -> None:
        assert is_us_location("Austin, TX", [])

    def test_city_state_full(self) -> None:
        assert is_us_location("Austin, Texas", [])

    def test_full_address(self) -> None:
        assert is_us_location("Austin, Texas, United States", [])

    def test_usa(self) -> None:
        assert is_us_location("San Francisco, CA, USA", [])

    def test_ambiguous_remote_dropped(self) -> None:
        assert not is_us_location("Remote", [])

    def test_remote_us_kept(self) -> None:
        assert is_us_location("Remote in US", [])

    def test_empty_location_dropped(self) -> None:
        assert not is_us_location("", [])

    def test_no_locations_dropped(self) -> None:
        assert not is_us_location("", [])

    def test_dc(self) -> None:
        assert is_us_location("Washington, DC", [])

    def test_locations_list_us(self) -> None:
        assert is_us_location("", ["New York, NY", "Boston, MA"])

    def test_opaque_workday_id_dropped(self) -> None:
        assert not is_us_location("R249096", [])

    def test_opaque_numeric_dropped(self) -> None:
        assert not is_us_location("10153195", [])

    def test_india_dropped(self) -> None:
        assert not is_us_location("Bangalore, India", [])

    def test_india_in_locations(self) -> None:
        assert not is_us_location("", ["Bengaluru, Karnataka, India"])

    def test_uk_dropped(self) -> None:
        assert not is_us_location("London, United Kingdom", [])

    def test_germany_dropped(self) -> None:
        assert not is_us_location("Berlin, Germany", [])

    def test_netherlands_dropped(self) -> None:
        assert not is_us_location("Amsterdam, Netherlands", [])

    def test_australia_dropped(self) -> None:
        assert not is_us_location("Sydney, Australia", [])

    def test_new_zealand_dropped(self) -> None:
        assert not is_us_location("Auckland, New Zealand", [])

    def test_mixed_us_and_non_us_kept(self) -> None:
        assert is_us_location("", ["New York, NY", "London, UK"])

    def test_united_states_in_string(self) -> None:
        assert is_us_location("Ashville, Ohio, United States", [])

    def test_state_name_california(self) -> None:
        assert is_us_location("South San Francisco, California", [])

    def test_unknown_city_dropped(self) -> None:
        assert not is_us_location("Ann Arbor", [])


class TestFilterUsLocations:
    def test_filters_non_us(self) -> None:
        us = MagicMock()
        us.title = "Intern"
        us.location = "Austin, TX"
        us.locations = []

        india = MagicMock()
        india.title = "Intern"
        india.location = "Bangalore, India"
        india.locations = []

        result = filter_us_locations([us, india])
        assert len(result) == 1
        assert us in result

    def test_empty_list(self) -> None:
        assert filter_us_locations([]) == []


class TestFilterFeedMapping:
    def test_keeps_only_in_scope_postings(self) -> None:
        intern_us = MagicMock()
        intern_us.title = "Software Engineering Intern"
        intern_us.location = "Austin, TX"
        intern_us.locations = ["Austin, TX"]

        full_time_us = MagicMock()
        full_time_us.title = "Software Engineer"
        full_time_us.location = "Austin, TX"
        full_time_us.locations = ["Austin, TX"]

        intern_canada = MagicMock()
        intern_canada.title = "Software Engineering Intern"
        intern_canada.location = "Toronto, Canada"
        intern_canada.locations = ["Toronto, Canada"]

        result = filter_feed_mapping({
            "keep": intern_us,
            "wrong-role": full_time_us,
            "wrong-country": intern_canada,
        })

        assert result == {"keep": intern_us}
